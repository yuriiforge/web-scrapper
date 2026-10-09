// Liveness for the container healthcheck: the web server is up and answering.
export function GET() {
  return Response.json({ status: "ok" });
}
