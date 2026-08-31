// CloudFront Function (viewer-request) for play-staging.fobal.ai — the
// unified app's clean routes (workstream J).
//
// Rule: a request with a file extension is a real object (pages, modules,
// styles, the golden reference) and passes through untouched; everything
// else — /, /onboarding, /squad, /market/42, /lobby, /play — is the app,
// served from /app.html. The app router reads the original path from the
// browser URL (CloudFront functions rewrite the origin request only, the
// address bar keeps the deep link).
//
// tools/serve-client.mjs mirrors this rule locally; change both together.
//
// Deploy (imperative, like the distribution itself — see
// docs/AWS_ARCHITECTURE.md for why this distribution is not CFN-managed):
//   aws cloudfront create-function --name fobal-app-router \
//     --function-config Comment="fobal unified app router",Runtime=cloudfront-js-2.0 \
//     --function-code fileb://infra/cloudfront/app-router-function.js
//   aws cloudfront publish-function --name fobal-app-router --if-match <ETag>
//   … then attach as the viewer-request function of the default behavior on
//   distribution E35URO4KFESJYU and invalidate '/*'.
//
// Until this function is attached, the app remains fully usable at
// /app.html — its router falls back to ?p= query routing on its own.

function handler(event) {
  var request = event.request;
  var uri = request.uri;
  if (uri.endsWith('/') && uri !== '/') uri = uri.replace(/\/+$/, '');
  var lastSegment = uri.split('/').pop();
  if (uri === '/' || lastSegment.indexOf('.') === -1) {
    request.uri = '/app.html';
  }
  return request;
}
