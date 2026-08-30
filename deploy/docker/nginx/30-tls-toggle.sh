#!/bin/sh
# MoviesAboard — TLS toggle for the web (nginx) container.
#
# Drop-in for /docker-entrypoint.d/. The 30- prefix runs it after the
# image's 20-envsubst-on-templates.sh has rendered
# /etc/nginx/conf.d/tls.conf from tls.conf.template. If the cert pair in
# /data/certs/ is incomplete, remove that rendered config so nginx boots
# cleanly with the HTTP server only. POSIX sh — the nginx image has no
# bash.
#
# When MOVIESABOARD_TLS is set to anything but "off", certs are EXPECTED:
# in self-signed mode the station container generates them at its own
# boot, which can race this script on a cold start. Wait up to 30s for
# the pair before deciding, so `MOVIESABOARD_TLS=self-signed docker
# compose up` reliably serves 443 on the first boot.
set -eu

tls_conf=/etc/nginx/conf.d/tls.conf
mode="${MOVIESABOARD_TLS:-off}"

have_certs() {
    [ -f /data/certs/fullchain.pem ] && [ -f /data/certs/privkey.pem ]
}

if [ "$mode" != "off" ] && ! have_certs; then
    echo "moviesaboard: TLS mode '$mode' — waiting up to 30s for cert pair" >&2
    i=0
    while [ "$i" -lt 30 ] && ! have_certs; do
        sleep 1
        i=$((i + 1))
    done
fi

if ! have_certs; then
    rm -f "$tls_conf"
    echo "moviesaboard: no cert pair in /data/certs — TLS is off" >&2
else
    echo "moviesaboard: cert pair found — serving 443" >&2
fi
