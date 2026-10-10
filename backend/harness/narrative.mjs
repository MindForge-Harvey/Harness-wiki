/** Move long Chinese prose asides into sentences without changing facts or technical notation. */
export function plainAssistantText(value) {
  if (typeof value !== 'string') return value
  const protectedParts = /(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`|\$\$[\s\S]*?\$\$|\$[^$\n]*\$|\[[^\]\n]*\]\([^)]+\)|^[ \t]*(?:>|\|)[^\n]*)/gm
  return value.split(protectedParts).map((part, index) => index % 2 ? part
    : part.replace(/[^。！？\n]+(?:[。！？]|$)/g, sentence => {
      if (/^\s*\|/.test(sentence) || /（[^）]*（/.test(sentence)) return sentence
      const notes = []
      const main = sentence.replace(/（([^（）\n]{12,})）/gu, (original, note) => {
        if (!/\p{Script=Han}/u.test(note) || /[=+*/^<>]|\\[a-z]+/i.test(note)) return original
        notes.push(note)
        return ''
      })
      if (!notes.length || !main.trim()) return sentence
      return main + (/[。！？]$/.test(main) ? '' : '。')
        + notes.map(note => /[。！？]$/.test(note) ? note : note + '。').join('')
    })).join('')
}
