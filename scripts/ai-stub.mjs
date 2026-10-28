/**
 * Stand-in for the `ai` package, used only while reading tool definitions out
 * of a livetennisapi-ai tarball. The real `tool()` returns its argument; so
 * does this one. Nothing here is executed by the server.
 */
export const tool = (definition) => definition;
