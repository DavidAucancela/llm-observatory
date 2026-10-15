import { useEffect, useState } from 'react';

const QUERY = '(pointer: coarse)';

// True when the primary input is a finger (phones, tablets). Charts use it to
// swap mouse gestures (drag to rotate, wheel to zoom, hover) for touch-safe ones.
export function useCoarsePointer() {
  const [coarse, setCoarse] = useState(() => typeof window !== 'undefined' && !!window.matchMedia?.(QUERY).matches);
  useEffect(() => {
    const mq = window.matchMedia?.(QUERY);
    if (!mq) return undefined;
    const onChange = () => setCoarse(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return coarse;
}
