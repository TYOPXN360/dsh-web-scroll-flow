/**
 * Lightweight Markdown-to-HTML for think body content.
 * Covers: code blocks, inline code, bold, italic, headers, lists, links,
 * horizontal rules, blockquotes. Not a full GFM parser — good enough for
 * streaming thinking text.
 */

const ESCAPE_RE = /[&<>"']/g
const ESCAPE_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function escapeHtml(s: string): string {
  return s.replace(ESCAPE_RE, c => ESCAPE_MAP[c] ?? c)
}

export function thinkMarkdownToHtml(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let inCode = false
  let codeLang = ''
  let inList = false
  let listMarker = ''

  const closeList = (): void => {
    if (inList) { out.push(listMarker === 'ol' ? '</ol>' : '</ul>'); inList = false }
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!

    // Fenced code blocks
    if (line.trimStart().startsWith('```')) {
      if (!inCode) {
        closeList()
        codeLang = line.trimStart().slice(3).trim()
        const langAttr = codeLang !== '' ? ` class="language-${escapeHtml(codeLang)}"` : ''
        out.push(`<pre><code${langAttr}>`)
        inCode = true
        continue
      }
      out.push('</code></pre>')
      inCode = false
      continue
    }

    if (inCode) {
      out.push(escapeHtml(line))
      continue
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line)) {
      closeList()
      out.push('<hr>')
      continue
    }

    // Headers
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headerMatch) {
      closeList()
      const level = headerMatch[1]!.length
      out.push(`<h${level}>${inlineMd(headerMatch[2]!)}</h${level}>`)
      continue
    }

    // Blockquote
    if (line.startsWith('> ')) {
      closeList()
      out.push(`<blockquote>${inlineMd(line.slice(2))}</blockquote>`)
      continue
    }

    // Unordered list
    const ulMatch = line.match(/^(\s*)[-*+]\s+(.+)$/)
    if (ulMatch) {
      if (!inList || listMarker !== 'ul') { closeList(); out.push('<ul>'); inList = true; listMarker = 'ul' }
      out.push(`<li>${inlineMd(ulMatch[2]!)}</li>`)
      continue
    }

    // Ordered list
    const olMatch = line.match(/^(\s*)\d+\.\s+(.+)$/)
    if (olMatch) {
      if (!inList || listMarker !== 'ol') { closeList(); out.push('<ol>'); inList = true; listMarker = 'ol' }
      out.push(`<li>${inlineMd(olMatch[2]!)}</li>`)
      continue
    }

    // Empty line = paragraph break
    closeList()
    if (line.trim() === '') {
      out.push('')
      continue
    }

    // Regular paragraph
    out.push(`<p>${inlineMd(line)}</p>`)
  }

  if (inCode) out.push('</code></pre>')
  closeList()

  return out.join('\n')
}

/** Inline Markdown: bold, italic, inline code, links, images. */
function inlineMd(text: string): string {
  // Inline code first (protect from other transforms)
  let result = text.replace(/`([^`]+)`/g, (_, code) => `<code>${escapeHtml(code)}</code>`)
  // Images
  result = result.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
  // Links
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  // Bold (** or __)
  result = result.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
  result = result.replace(/__(.+?)__/g, '<strong>$1</strong>')
  // Italic (* or _)
  result = result.replace(/\*(.+?)\*/g, '<em>$1</em>')
  result = result.replace(/_(.+?)_/g, '<em>$1</em>')
  // Strikethrough
  result = result.replace(/~~(.+?)~~/g, '<del>$1</del>')
  return result
}
