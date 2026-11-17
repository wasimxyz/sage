import Link from "next/link";

export function AppHeader() {
  return (
    <p className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
      <Link className="hover:text-foreground" href="/">
        eve / Sage evals
      </Link>
      {process.env.NODE_ENV === "development" ? (
        <Link className="hover:text-foreground" href="/calibration">
          Grade by hand
        </Link>
      ) : null}
    </p>
  );
}
