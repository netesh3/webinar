# The mix recorder (recorder.go): joins MediaMTX's rec/* segments into an MP4 and uploads it.
# Built on the box by redeploy.sh, like the caption agent. ffmpeg is only ever a copy (-c copy).
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mixrec .

FROM alpine:3.20
RUN apk add --no-cache ffmpeg ca-certificates
COPY --from=build /mixrec /usr/local/bin/mixrec
# Root, like MediaMTX, whose files under /recordings this deletes once uploaded.
ENTRYPOINT ["/usr/local/bin/mixrec"]
