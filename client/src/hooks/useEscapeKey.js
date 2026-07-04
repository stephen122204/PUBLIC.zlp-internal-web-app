import { useEffect, useRef } from 'react';

// Global stack so only the topmost modal responds to Escape.
// Each mounted modal pushes its handler; only the last entry fires.
const _stack = [];

export function useEscapeKey(onClose) {
  const ref = useRef(onClose);
  ref.current = onClose;

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape' && _stack[_stack.length - 1] === handler) {
        ref.current();
      }
    };
    _stack.push(handler);
    document.addEventListener('keydown', handler);
    return () => {
      document.removeEventListener('keydown', handler);
      const idx = _stack.indexOf(handler);
      if (idx !== -1) _stack.splice(idx, 1);
    };
  }, []);
}
