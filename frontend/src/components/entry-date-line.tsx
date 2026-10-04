import { useEffect, useState } from "react";

import { formatEntryDate } from "@/lib/format-date";
import { formatLastEdited } from "@/lib/format-relative-age";

const ageTickMs = 60_000;

export function EntryDateLine({
  date,
  updatedAt,
}: {
  date: string;
  updatedAt: string;
}) {
  return (
    <>
      <time dateTime={date}>{formatEntryDate(date)}</time>
      <LastEdited at={updatedAt} />
    </>
  );
}

function LastEdited({ at }: { at: string }) {
  const now = useRelativeNow();
  const label = formatLastEdited(at, now);
  if (label.length === 0) {
    return null;
  }
  return (
    <>
      {" · "}
      <time dateTime={at}>{label}</time>
    </>
  );
}

function useRelativeNow(): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = window.setInterval(() => {
      setNow(Date.now());
    }, ageTickMs);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  return now;
}
