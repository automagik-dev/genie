// What Genie's empty chat offers: chips above the composer (the Bot team's chatSuggestions,
// bots-dsh 3.23 and later) that fill it with a start the person finishes. They lead the
// team's own (order below 0), and only in a Genie's chat.
export const GENIE_SUGGESTIONS = Object.freeze({
  id: 'genie',
  order: -10,
  when: ({ bot }) => bot?.kind === 'genie',
  items: () => [
    { id: 'wish', label: 'Make a wish', text: 'I wish ', icon: 'SparkIcon' },
    { id: 'fix', label: 'Find what to fix', text: 'What should I fix first in this project? ', icon: 'SearchIcon' },
    { id: 'idea', label: 'Think through an idea', text: 'Help me think through an idea: ', icon: 'MessageIcon' },
  ],
});

/** Registers Genie's chips where the team offers the hook; an older team has none, and gets none. */
export function registerSuggestions(chatSuggestions) {
  return chatSuggestions?.register ? chatSuggestions.register(GENIE_SUGGESTIONS) : () => {};
}
