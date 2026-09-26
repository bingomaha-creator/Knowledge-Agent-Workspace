#!/bin/sh
set -eu
cd "$(dirname "$0")"
runtimeDir="$PWD/data/neo4j-runtime"
test -x "$runtimeDir/neo4j-community-5.22.0/bin/neo4j" || {
  echo 'Local Neo4j runtime is missing; use npm run research-sidecar:neo4j (Docker).' >&2
  exit 1
}
# Neo4j 5.22's launcher escapes Chinese paths. Only the alias is temporary; data stays in the project.
runtimeAlias=$(mktemp -d /private/tmp/knowledge-agent-neo4j.XXXXXX)
ln -s "$runtimeDir/neo4j-community-5.22.0" "$runtimeAlias/home"
ln -s "$runtimeDir/conf" "$runtimeAlias/conf"
trap 'rm "$runtimeAlias/home" "$runtimeAlias/conf"; rmdir "$runtimeAlias"' EXIT
NEO4J_HOME="$runtimeAlias/home" NEO4J_CONF="$runtimeAlias/conf" "$runtimeAlias/home/bin/neo4j" console
