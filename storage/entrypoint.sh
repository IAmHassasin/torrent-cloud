#!/bin/sh
# Starts SeaweedFS (master + volume + filer + S3 gateway) with one S3 identity
# whose credentials come from the environment.
set -eu

if [ -z "${S3_ACCESS_KEY_ID:-}" ] || [ -z "${S3_SECRET_ACCESS_KEY:-}" ]; then
  echo "S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY are required" >&2
  exit 1
fi

umask 077
cat > /tmp/s3.json <<EOF
{
  "identities": [
    {
      "name": "torrent-cloud",
      "credentials": [
        { "accessKey": "${S3_ACCESS_KEY_ID}", "secretKey": "${S3_SECRET_ACCESS_KEY}" }
      ],
      "actions": ["Admin", "Read", "List", "Write", "Tagging"]
    }
  ]
}
EOF

exec weed server -dir=/data -volume.max=0 -s3 -s3.port=8333 -s3.config=/tmp/s3.json
