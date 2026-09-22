// Presentation constants. A quad's colour lives here, not in the store: colour is a presentation
// concern, and src/core must stay free of anything to do with how things look.
//
// One accent hue (amber), ramped by brightness — not four unrelated hues. Deciding "which one's
// brightest" is a magnitude read; deciding "which hue means what" is a category you have to have
// memorised first. For four things that are actually ranked, the magnitude read is faster.
// Amber rather than green: green already means "done" twice over elsewhere (.resolving's #8fd08f,
// .task-act.done/.push's #3a7 hover), and warm-for-urgent still matches how people read colour
// outside this app too. Q4 stays plain grey — off the ramp entirely, i.e. "no signal".
// (This map is the one place that changes; test/app/ui.electron.js keeps its own copy for
// assertions and needs updating alongside it.)
export const COLORS = {
  1: 'hsl(28, 100%, 54%)',
  2: 'hsl(28, 68%, 40%)',
  3: 'hsl(28, 45%, 27%)',
  4: '#9aa0a8',
};
