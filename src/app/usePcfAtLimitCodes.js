import { useEffect, useState } from 'react';
import { pcfEventsClient } from './etfPcfEventsClient.js';

const EMPTY_CODES = new Set();

// 与份额订阅解耦，只随限额基准日重新订阅；旧日期的迟到结果不能给新日期加标记。
export function usePcfAtLimitCodes(limitBaseline) {
  const [result, setResult] = useState({ date: null, codes: EMPTY_CODES });
  useEffect(() => {
    if (!limitBaseline) return undefined;
    let active = true;
    const subscription = pcfEventsClient.subscribe(limitBaseline);
    subscription.promise.then(codes => {
      if (active) setResult({ date: limitBaseline, codes });
    });
    return () => {
      active = false;
      subscription.release();
    };
  }, [limitBaseline]);
  return result.date === limitBaseline ? result.codes : EMPTY_CODES;
}
