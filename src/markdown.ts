// ---------------------------------------------------------------------------
// BrowserClaw — Lightweight Markdown → HTML renderer
// ---------------------------------------------------------------------------
//
// Zero dependencies.  Handles the subset of Markdown that Claude outputs:
//   - Headings (#, ##, ###, ####)
//   - Bold (**text**), italic (*text* / _text_), bold-italic (***text***),
//     strikethrough (~~text~~)
//   - Inline code (`code`), fenced code blocks (```lang … ```)
//   - Unordered lists (- / *), ordered lists (1.)
//   - Blockquotes (>)
//   - Horizontal rules (---, ***)
//   - Links [text](url), auto-links
//   - Images ![alt](src)  — PNG, JPG, SVG, data URIs
//   - Inline SVG (<svg …> … </svg>)
//   - Tables (GFM pipe tables with optional alignment)
//   - Paragraphs / line breaks
//
// Security: all literal HTML (except <svg>) is escaped.  SVGs are sanitised
// to remove event handlers and <script> elements.
// ---------------------------------------------------------------------------

/**
 * Render a Markdown string to safe HTML.
 */
export function renderMarkdown(src: string): string {
  // Normalise line endings
  const input = src.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // Protect fenced code blocks from further processing
  const codeBlocks: string[] = [];
  const withCodePlaceholders = input.replace(
    /^```(\w*)\n([\s\S]*?)^```$/gm,
    (_, lang, code) => {
      const idx = codeBlocks.length;
      const escaped = escapeHtml(code.replace(/\n$/, ''));
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      codeBlocks.push(`<pre><code${langAttr}>${escaped}</code></pre>`);
      return `\x00CODE${idx}\x00`;
    },
  );

  // Split into lines for block-level processing
  const lines = withCodePlaceholders.split('\n');
  const html = processBlocks(lines);

  // Restore code blocks
  let result = html;
  for (let i = 0; i < codeBlocks.length; i++) {
    result = result.replace(`\x00CODE${i}\x00`, codeBlocks[i]);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Block-level processing
// ---------------------------------------------------------------------------

function processBlocks(lines: string[]): string {
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code-block placeholder (already processed)
    if (/^\x00CODE\d+\x00$/.test(line)) {
      out.push(line);
      i++;
      continue;
    }

    // Blank line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
    if (headingMatch) {
      const level = headingMatch[1].length;
      out.push(`<h${level}>${inlineMarkdown(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Table (GFM pipe table)
    if (i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const tableLines: string[] = [line];
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== '' && lines[j].includes('|')) {
        tableLines.push(lines[j]);
        j++;
      }
      out.push(renderTable(tableLines));
      i = j;
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines: string[] = [];
      let j = i;
      while (j < lines.length && (lines[j].startsWith('>') || (lines[j].trim() !== '' && quoteLines.length > 0 && !lines[j].startsWith('#')))) {
        if (lines[j].startsWith('>')) {
          quoteLines.push(lines[j].replace(/^>\s?/, ''));
        } else {
          break;
        }
        j++;
      }
      out.push(`<blockquote>${processBlocks(quoteLines)}</blockquote>`);
      i = j;
      continue;
    }

    // Unordered list
    if (/^[\s]*[-*+]\s/.test(line)) {
      const { html: listHtml, consumed } = parseList(lines, i, 'ul');
      out.push(listHtml);
      i += consumed;
      continue;
    }

    // Ordered list
    if (/^[\s]*\d+\.\s/.test(line)) {
      const { html: listHtml, consumed } = parseList(lines, i, 'ol');
      out.push(listHtml);
      i += consumed;
      continue;
    }

    // Inline SVG block — pass through with sanitisation
    if (line.trim().startsWith('<svg')) {
      const svgLines: string[] = [];
      let j = i;
      let depth = 0;
      while (j < lines.length) {
        svgLines.push(lines[j]);
        depth += (lines[j].match(/<svg[\s>]/g) || []).length;
        depth -= (lines[j].match(/<\/svg>/g) || []).length;
        j++;
        if (depth <= 0) break;
      }
      out.push(sanitiseSvg(svgLines.join('\n')));
      i = j;
      continue;
    }

    // Paragraph — collect consecutive non-blank, non-block lines
    {
      const paraLines: string[] = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trim() === '') break;
        if (/^(#{1,6}\s|>\s?|[-*+]\s|\d+\.\s|```|\x00CODE)/.test(l)) break;
        if (l.trim().startsWith('<svg')) break;
        paraLines.push(l);
        j++;
      }
      if (paraLines.length > 0) {
        out.push(`<p>${inlineMarkdown(paraLines.join('\n'))}</p>`);
        i = j;
      } else {
        i++;
      }
    }
  }

  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

function isTableSeparator(line: string): boolean {
  return /^\|?[\s]*:?-+:?[\s]*(\|[\s]*:?-+:?[\s]*)*\|?$/.test(line.trim());
}

function renderTable(lines: string[]): string {
  if (lines.length < 2) return '';

  const parseRow = (line: string): string[] =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());

  const headers = parseRow(lines[0]);
  const separators = parseRow(lines[1]);

  // Determine alignment from separator row
  const aligns: string[] = separators.map((s) => {
    const left = s.startsWith(':');
    const right = s.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    return 'left';
  });

  let html = '<table><thead><tr>';
  for (let c = 0; c < headers.length; c++) {
    const align = aligns[c] ? ` style="text-align:${aligns[c]}"` : '';
    html += `<th${align}>${inlineMarkdown(headers[c])}</th>`;
  }
  html += '</tr></thead><tbody>';

  for (let r = 2; r < lines.length; r++) {
    const cells = parseRow(lines[r]);
    html += '<tr>';
    for (let c = 0; c < headers.length; c++) {
      const align = aligns[c] ? ` style="text-align:${aligns[c]}"` : '';
      html += `<td${align}>${inlineMarkdown(cells[c] ?? '')}</td>`;
    }
    html += '</tr>';
  }

  html += '</tbody></table>';
  return html;
}

// ---------------------------------------------------------------------------
// List rendering
// ---------------------------------------------------------------------------

function parseList(
  lines: string[],
  start: number,
  type: 'ul' | 'ol',
): { html: string; consumed: number } {
  const items: string[] = [];
  let i = start;
  const pattern = type === 'ul' ? /^(\s*)[-*+]\s(.*)/ : /^(\s*)\d+\.\s(.*)/;

  while (i < lines.length) {
    const m = lines[i].match(pattern);
    if (m) {
      items.push(m[2]);
      i++;
    } else if (lines[i].trim() === '') {
      // A blank line might end the list or continue it
      if (i + 1 < lines.length && pattern.test(lines[i + 1])) {
        i++;
        continue;
      }
      break;
    } else if (lines[i].startsWith('  ') || lines[i].startsWith('\t')) {
      // Continuation of previous item
      if (items.length > 0) {
        items[items.length - 1] += '\n' + lines[i].replace(/^\s{2,}|\t/, '');
      }
      i++;
    } else {
      break;
    }
  }

  const inner = items
    .map((item) => `<li>${inlineMarkdown(item)}</li>`)
    .join('');

  return { html: `<${type}>${inner}</${type}>`, consumed: i - start };
}

// ---------------------------------------------------------------------------
// Inline Markdown
// ---------------------------------------------------------------------------

function inlineMarkdown(text: string): string {
  let s = text;

  // Escape HTML entities (but preserve code ticks for next step)
  s = escapeHtml(s);

  // Inline code — must run before other transforms to protect contents
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Images: ![alt](src)
  s = s.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    (_, alt, src) => {
      const safeSrc = escapeAttr(restoreHtmlEntities(src));
      const safeAlt = escapeAttr(alt);
      return `<img src="${safeSrc}" alt="${safeAlt}" loading="lazy">`;
    },
  );

  // Links: [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, text, url) => {
      const safeUrl = escapeAttr(restoreHtmlEntities(url));
      return `<a href="${safeUrl}" target="_blank" rel="noopener">${text}</a>`;
    },
  );

  // Bold + italic
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

  // Bold
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Line breaks (double space + newline or explicit \n in paragraph)
  s = s.replace(/ {2,}\n/g, '<br>');
  s = s.replace(/\n/g, '<br>');

  return s;
}

// ---------------------------------------------------------------------------
// SVG sanitisation
// ---------------------------------------------------------------------------

function sanitiseSvg(raw: string): string {
  // Remove <script> elements
  let svg = raw.replace(/<script[\s\S]*?<\/script>/gi, '');

  // Remove event handler attributes (on*)
  svg = svg.replace(/\s+on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]*)/gi, '');

  // Remove javascript: URLs
  svg = svg.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, '');
  svg = svg.replace(/xlink:href\s*=\s*["']javascript:[^"']*["']/gi, '');

  // Make SVG responsive: extract width/height to build a viewBox if missing,
  // then remove fixed width/height so CSS can control sizing.
  const svgTagMatch = svg.match(/<svg([^>]*)>/i);
  if (svgTagMatch) {
    let attrs = svgTagMatch[1];
    const hasViewBox = /viewBox/i.test(attrs);

    // Extract numeric width/height
    const wMatch = attrs.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)/i);
    const hMatch = attrs.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)/i);

    // If no viewBox but we have width+height, synthesise one
    if (!hasViewBox && wMatch && hMatch) {
      attrs += ` viewBox="0 0 ${wMatch[1]} ${hMatch[1]}"`;
    }

    // Remove fixed width/height so CSS max-width works
    attrs = attrs.replace(/\bwidth\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '');
    attrs = attrs.replace(/\bheight\s*=\s*("[^"]*"|'[^']*'|\S+)/gi, '');

    svg = svg.replace(/<svg[^>]*>/i, `<svg${attrs}>`);
  }

  // Wrap in a container div for styling
  return `<div class="md-svg">${svg}</div>`;
}

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Restore HTML entities that were escaped — needed for URLs inside markdown */
function restoreHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"');
}
