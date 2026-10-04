// WKWebView has no Symbol.dispose yet. eve's chat client uses `using`
// declarations, which need it; without this shim, reopening a saved
// chat throws "Object is not disposable."
//
// The page loads this file before the app, and it stays a file: the page
// rule in frontend/index.html allows no inline script.
//
// TS's ES2022 lib does not name these symbols, so name them here.

interface DisposableSymbols {
  asyncDispose?: symbol;
  dispose?: symbol;
}

const symbols = Symbol as DisposableSymbols;

if (symbols.dispose === undefined) {
  symbols.dispose = Symbol.for("Symbol.dispose");
}

if (symbols.asyncDispose === undefined) {
  symbols.asyncDispose = Symbol.for("Symbol.asyncDispose");
}
