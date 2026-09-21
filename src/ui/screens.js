// The panel has two screens: the main one (axis + list + input) and the ⚙ one (crossed off +
// settings). This owns which is showing. What else should happen when it changes (closing the menu,
// focusing the input) is the caller's business, passed in as onChange, so this file stays about
// screens only.
export function createScreens({ main, done, gearBtn }, { onChange }) {
  let current = 'main';

  function show(name) {
    current = name;
    main.classList.toggle('active', name === 'main');
    done.classList.toggle('active', name === 'done');
    gearBtn.classList.toggle('on', name === 'done');
    onChange(name);
  }

  return { show, current: () => current };
}
