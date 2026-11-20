/** Enter/Escape may still belong to the input method while choosing Chinese text. */
export function isComposing(event: { isComposing?: boolean; keyCode?: number }) {
  return event.isComposing || event.keyCode === 229;
}
