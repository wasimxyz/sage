import Link from "next/link";

export function AppHeader() {
  return (
    <p className="text-muted-foreground font-mono text-xs">
      <Link className="hover:text-foreground" href="/">
        eve / Sage evals
      </Link>
    </p>
  );
}
