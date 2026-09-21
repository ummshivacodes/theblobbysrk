// The panel has three screens: the main one (axis + list + input), the Notes one (search + notes), and the
// ⚙ one (crossed off + settings). This owns which is showing. What else should happen when it changes
// (closing the menu, focusing a box) is the caller's business, passed in as onChange, so this file stays
// about screens only.
export function createScreens({ main, notes, done, gearBtn, notesBtn }, { onChange }) {
  let current = 'main';

  function show(name) {
    current = name;
    main.classList.toggle('active', name === 'main');
    notes.classList.toggle('active', name === 'notes');
    done.classList.toggle('active', name === 'done');
    notesBtn.classList.toggle('on', name === 'notes');
    gearBtn.classList.toggle('on', name === 'done');
    onChange(name);
  }

  return { show, current: () => current };
}
