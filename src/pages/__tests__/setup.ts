import "@testing-library/jest-dom";

// jsdom lacks the Pointer Capture API and scrollIntoView; radix-ui components
// (Select, Dialog, etc.) call these on open/close, which would otherwise throw.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
