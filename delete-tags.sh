#!/bin/bash

if [ -z "$1" ]; then
    echo "Please provide a version number as parameter"
    echo "Usage: $0 <version>"
    exit 1
fi

VERSION=$1

echo "Deleting tags for version $VERSION..."

git tag -d client@$VERSION 2>/dev/null && \
git push origin :refs/tags/client@$VERSION 2>/dev/null && \
echo "Deleted client tag"

git tag -d bloom@$VERSION 2>/dev/null && \
git push origin :refs/tags/bloom@$VERSION 2>/dev/null && \
echo "Deleted bloom tag"

git tag -d entraid@$VERSION 2>/dev/null && \
git push origin :refs/tags/entraid@$VERSION 2>/dev/null && \
echo "Deleted entraid tag"

git tag -d json@$VERSION 2>/dev/null && \
git push origin :refs/tags/json@$VERSION 2>/dev/null && \
echo "Deleted json tag"

git tag -d search@$VERSION 2>/dev/null && \
git push origin :refs/tags/search@$VERSION 2>/dev/null && \
echo "Deleted search tag"

git tag -d time-series@$VERSION 2>/dev/null && \
git push origin :refs/tags/time-series@$VERSION 2>/dev/null && \
echo "Deleted time-series tag"

git tag -d redis@$VERSION 2>/dev/null && \
git push origin :refs/tags/redis@$VERSION 2>/dev/null && \
echo "Deleted redis tag"

echo "Done!"
