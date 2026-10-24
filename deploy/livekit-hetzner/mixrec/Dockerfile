# The mix recorder (recorder.go): joins MediaMTX's rec/* segments into an MP4 and uploads it;
# and the clip maker (clips.go): renders hosts' clips and reels between sessions.
# Built on the box by redeploy.sh, like the caption agent.
#
# Alpine's ffmpeg is enough for both: the joins are a copy (-c copy), and the clips need
# libx264, AAC, loudnorm and libass with fontconfig, freetype, fribidi and harfbuzz, all of
# which Alpine builds it with (ffmpeg -buildconf). The one thing it lacks is a font: Inter
# (SIL Open Font License 1.1, font-inter) for the captions and hook titles. fontconfig's
# cache is built by the package's trigger, so libass finds it by name.
FROM golang:1.24-alpine AS build
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /mixrec .

FROM alpine:3.20
RUN apk add --no-cache ffmpeg font-inter ca-certificates
COPY --from=build /mixrec /usr/local/bin/mixrec
# Root, like MediaMTX, whose files under /recordings this deletes once uploaded.
ENTRYPOINT ["/usr/local/bin/mixrec"]
