# A throwaway SSH host for test/integration/run-remote.mjs. See CONTRIBUTING.md, "Remote windows".
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server git ca-certificates curl wget tar procps \
 && rm -rf /var/lib/apt/lists/* && mkdir -p /run/sshd \
 && useradd -m -s /bin/bash dev && mkdir -p /home/dev/.ssh \
 && printf 'PasswordAuthentication no\nAllowTcpForwarding yes\n' >> /etc/ssh/sshd_config
# The public key is passed at run time (AUTHORIZED_KEY), so the image holds no key.
CMD ["sh", "-c", "echo \"$AUTHORIZED_KEY\" > /home/dev/.ssh/authorized_keys && chown -R dev /home/dev/.ssh && chmod 700 /home/dev/.ssh && chmod 600 /home/dev/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e"]
