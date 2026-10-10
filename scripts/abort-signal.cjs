"use strict";

// Node 24.21 lazily follows composite signals, but retains timeout composites
// passed to any(). Nested, unobserved composites then survive their timeout.
// Briefly observing each result starts native weak following without retaining
// a listener. Keep native validation, flattening, abort reasons and ordering.
const nativeAny = AbortSignal.any;
const observe = () => {};
AbortSignal.any = function any(signals) {
  const signal = nativeAny(signals);
  signal.addEventListener("abort", observe);
  signal.removeEventListener("abort", observe);
  return signal;
};
