import Link from "next/link";

export function AppHeader() {
  return (
    <p className="font-mono text-muted-foreground text-xs">
      <Link className="hover:text-foreground" href="/">
        eve / Sage evals
      </Link>
    </p>
  );
}
