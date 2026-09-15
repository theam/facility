FROM scratch
COPY busybox /busybox
COPY app/index.html /www/index.html
COPY --chmod=0755 app/items /www/cgi-bin/items
ENTRYPOINT ["/busybox", "httpd", "-f", "-p", "3000", "-h", "/www"]
