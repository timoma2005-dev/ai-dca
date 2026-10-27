import { cx } from '../../components/experience-ui.jsx';
import { useMarketSentimentWeather } from './marketSentimentWeather.js';

export function MarketSentimentPageSurface({ children, className = '', padBottom = true, fillHeight = false, direct = false }) {
  // direct：本地直连模式，天气背景改用浏览器直连行情，不请求云端。
  const { weather } = useMarketSentimentWeather(undefined, { direct });

  return (
    <div
      data-market-sentiment-background="true"
      className={cx(
        'relative h-full min-h-[calc(100vh-var(--brand-bar-h,48px))] transition-colors',
        padBottom ? 'pb-[calc(72px+env(safe-area-inset-bottom))] md:pb-0' : '',
        weather.pageSurfaceClass,
        className,
      )}
    >
      <span
        className={cx(
          'pointer-events-none absolute right-4 top-4 select-none text-[8rem] leading-none opacity-20 sm:right-8 sm:top-8 sm:text-[11rem]',
          weather.decorClass,
        )}
        aria-hidden="true"
      >
        {weather.icon}
      </span>
      <span
        className={cx(
          'pointer-events-none absolute bottom-6 left-4 h-52 w-52 rounded-full blur-3xl',
          weather.orbClass,
        )}
        aria-hidden="true"
      />
      <div className={cx('relative z-[1] pt-4', fillHeight && 'flex h-full min-h-0 flex-col')}>{children}</div>
    </div>
  );
}
