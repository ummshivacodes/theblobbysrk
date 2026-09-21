import { activeThreads } from '../../core/selectors.js';

// The scoreboard row: Done x/y and how many are active. els = { done, listed, active }.
export function createScoreView({ done, listed, active }) {
  function render(snapshot) {
    done.textContent = snapshot.stats.done;
    listed.textContent = snapshot.stats.listed;
    active.textContent = activeThreads(snapshot).length;
  }
  return { render };
}
