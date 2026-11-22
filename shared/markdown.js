/**
 * Safe DOM-based Markdown renderer.
 * Builds elements directly via createElement/textContent instead of innerHTML
 * to eliminate XSS exposure from untrusted page or model content.
 */

function isSafeHttpUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Appends inline formatted nodes (bold, italic, inline code, links) to parent.
 * @param {HTMLElement} parent
 * @param {string} text
 * @param {Document} doc
 */
function appendInlineNodes(parent, text, doc) {
  const tokenRe = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match;

  while ((match = tokenRe.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parent.appendChild(doc.createTextNode(text.slice(lastIndex, match.index)));
    }
    const token = match[0];

    if (token.startsWith('`') && token.endsWith('`')) {
      const code = doc.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.appendChild(code);
    } else if (token.startsWith('**') && token.endsWith('**')) {
      const strong = doc.createElement('strong');
      strong.textContent = token.slice(2, -2);
      parent.appendChild(strong);
    } else if (token.startsWith('*') && token.endsWith('*')) {
      const em = doc.createElement('em');
      em.textContent = token.slice(1, -1);
      parent.appendChild(em);
    } else if (token.startsWith('[')) {
      const splitIdx = token.indexOf('](');
      const label = token.slice(1, splitIdx);
      const href = token.slice(splitIdx + 2, -1).trim();
      if (isSafeHttpUrl(href)) {
        const a = doc.createElement('a');
        a.href = href;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = label;
        parent.appendChild(a);
      } else {
        parent.appendChild(doc.createTextNode(label));
      }
    }

    lastIndex = tokenRe.lastIndex;
  }

  if (lastIndex < text.length) {
    parent.appendChild(doc.createTextNode(text.slice(lastIndex)));
  }
}

/**
 * Renders Markdown safely into a container element.
 * @param {HTMLElement} container
 * @param {string} markdown
 * @param {{ onCopyCode?: (code: string, btn: HTMLButtonElement) => void }} [options]
 */
export function renderMarkdown(container, markdown, options = {}) {
  const doc = container.ownerDocument || document;
  const fragment = doc.createDocumentFragment();
  const lines = (markdown || '').replace(/\r\n/g, '\n').split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].trimStart().startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;

      const codeText = codeLines.join('\n');
      const figure = doc.createElement('div');
      figure.className = 'md-code-block';

      const header = doc.createElement('div');
      header.className = 'md-code-header';

      const langSpan = doc.createElement('span');
      langSpan.className = 'md-code-lang';
      langSpan.textContent = lang || 'code';
      header.appendChild(langSpan);

      const copyBtn = doc.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'btn-ghost btn-xs';
      copyBtn.textContent = 'Copy';
      copyBtn.setAttribute('aria-label', 'Copy code snippet');
      copyBtn.addEventListener('click', () => {
        if (options.onCopyCode) {
          options.onCopyCode(codeText, copyBtn);
        } else if (navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(codeText).then(() => {
            copyBtn.textContent = 'Copied';
            setTimeout(() => {
              copyBtn.textContent = 'Copy';
            }, 1500);
          });
        }
      });
      header.appendChild(copyBtn);
      figure.appendChild(header);

      const pre = doc.createElement('pre');
      pre.setAttribute('role', 'region');
      pre.setAttribute('aria-label', lang ? `${lang} code snippet` : 'Code snippet');
      pre.tabIndex = 0;
      const code = doc.createElement('code');
      code.textContent = codeText;
      pre.appendChild(code);
      figure.appendChild(pre);

      fragment.appendChild(figure);
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Heading (#, ##, ###)
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      const p = doc.createElement('p');
      p.className = `md-heading md-heading-${headingMatch[1].length}`;
      appendInlineNodes(p, headingMatch[2].trim(), doc);
      fragment.appendChild(p);
      i++;
      continue;
    }

    // Blockquote
    if (line.trimStart().startsWith('> ')) {
      const quoteLines = [];
      while (i < lines.length && lines[i].trimStart().startsWith('> ')) {
        quoteLines.push(lines[i].trimStart().slice(2));
        i++;
      }
      const bq = doc.createElement('blockquote');
      appendInlineNodes(bq, quoteLines.join(' '), doc);
      fragment.appendChild(bq);
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const ul = doc.createElement('ul');
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        const li = doc.createElement('li');
        appendInlineNodes(li, lines[i].replace(/^\s*[-*]\s+/, ''), doc);
        ul.appendChild(li);
        i++;
      }
      fragment.appendChild(ul);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = doc.createElement('ol');
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = doc.createElement('li');
        appendInlineNodes(li, lines[i].replace(/^\s*\d+\.\s+/, ''), doc);
        ol.appendChild(li);
        i++;
      }
      fragment.appendChild(ol);
      continue;
    }

    // Paragraph (coalesce contiguous plain lines)
    const paraLines = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].trimStart().startsWith('```') &&
      !/^(#{1,4})\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('> ') &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    const p = doc.createElement('p');
    appendInlineNodes(p, paraLines.join(' '), doc);
    fragment.appendChild(p);
  }

  container.replaceChildren(fragment);
}
