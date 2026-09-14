# Licence server.
#
# Deliberately tiny: no dependencies beyond Node itself, so there is nothing to
# install and nothing to audit.
#
# The one thing that MUST be right is storage. LICENCE_DB has to point at a
# mounted volume. Most hosts give containers an ephemeral filesystem that is
# wiped on every restart and every deploy - and losing that file locks out every
# paying customer simultaneously, with no way to tell who they were.
FROM node:22-alpine

WORKDIR /app
COPY licence-server.js razorpay-webhook.js ./

# Where the volume gets mounted. Override LICENCE_DB if your host differs.
ENV LICENCE_DB=/data/licences.json
ENV PORT=8787
VOLUME ["/data"]

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8787/health || exit 1

CMD ["node", "licence-server.js"]
