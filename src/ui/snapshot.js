// What views are given to draw from: a deep-frozen COPY of the store's state. ES modules are always
// strict mode, so a view that tries to write to it throws immediately instead of silently corrupting
// data: views can read state but structurally cannot mutate it. (Dozens of small items, so the copy is
// free.)
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

export function takeSnapshot(state) {
  return deepFreeze(structuredClone(state));
}
