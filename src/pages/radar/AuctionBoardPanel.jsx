export default function AuctionBoardPanel() {
  return (
    <section
      className="h-[calc(100vh-10rem)] min-h-[560px] w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:h-[calc(100vh-8rem)] sm:min-h-[640px]"
      aria-label="竞价看板"
    >
      <iframe
        title="纳指期指与ETF竞价看板"
        src="/auction-board.html"
        className="h-full w-full border-0"
        loading="eager"
        referrerPolicy="strict-origin-when-cross-origin"
      />
    </section>
  );
}
