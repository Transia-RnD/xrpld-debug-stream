# docker build --platform linux/x86_64 --tag transia/cluster:3f954dd8ba7a8d5fbe1cb2a4981c3643cf84a5a2 --no-cache .
# docker push transia/cluster:3f954dd8ba7a8d5fbe1cb2a4981c3643cf84a5a2

FROM ubuntu:jammy as base

WORKDIR /app

LABEL maintainer="dangell@transia.co"

RUN export LANGUAGE=C.UTF-8; export LANG=C.UTF-8; export LC_ALL=C.UTF-8; export DEBIAN_FRONTEND=noninteractive

COPY entrypoint /entrypoint.sh
COPY rippled.batch-db /app/rippled

ENV RPC_PUBLIC=5017
ENV RPC_ADMIN=5015
ENV WS_PUBLIC=6018
ENV WS_ADMIN=6016
ENV PEER=2459

EXPOSE $RPC_PUBLIC $RPC_ADMIN $WS_PUBLIC $WS_ADMIN $PEER $PEER/udp
    
RUN chmod +x /entrypoint.sh &&         echo '#!/bin/bash' > /usr/bin/server_info &&         echo '/entrypoint.sh server_info' >> /usr/bin/server_info &&         chmod +x /usr/bin/server_info
ENTRYPOINT [ "/entrypoint.sh" ]