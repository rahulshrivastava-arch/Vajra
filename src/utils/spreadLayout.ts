export interface SpreadInfo {
  index: number;
  label: string;
  pages: number[];
}

export const getSpreads = (numPages: number, hasFrontCover: boolean, hasBackCover: boolean): SpreadInfo[] => {
  const spreads: SpreadInfo[] = [];
  if (numPages <= 0) return spreads;

  let index = 0;
  if (hasFrontCover) {
    spreads.push({
      index: index++,
      label: `Page 1`,
      pages: [1],
    });
  }

  const startPage = hasFrontCover ? 2 : 1;
  const endPage = hasBackCover ? numPages - 1 : numPages;

  for (let p = startPage; p <= endPage; p += 2) {
    if (p === endPage) {
      spreads.push({
        index: index++,
        label: `Page ${p}`,
        pages: [p],
      });
    } else {
      spreads.push({
        index: index++,
        label: `Pages ${p}-${p + 1}`,
        pages: [p, p + 1],
      });
    }
  }

  if (hasBackCover && numPages > (hasFrontCover ? 1 : 0)) {
    spreads.push({
      index: index++,
      label: `Page ${numPages}`,
      pages: [numPages],
    });
  }

  return spreads;
};
