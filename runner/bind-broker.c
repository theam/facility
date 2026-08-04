#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <sys/time.h>
#include <unistd.h>

#define MAX_ALIASES 1024
#define MAX_BATCH_ALIASES 128
#define MAX_REQUEST_BYTES ((MAX_BATCH_ALIASES * PATH_MAX) + 64)
#define REQUEST_TIMEOUT_SECONDS 5

static int workspace_fd = -1;
static char workspace_view[PATH_MAX];
static uid_t allowed_uid;
static unsigned int alias_count;

static void fail(const char *message) {
  perror(message);
  exit(EXIT_FAILURE);
}

static bool write_all(int fd, const char *buffer, size_t length) {
  while (length > 0) {
    ssize_t written = write(fd, buffer, length);
    if (written < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    buffer += written;
    length -= (size_t)written;
  }
  return true;
}

static void respond_error(int client, const char *reason) {
  char response[256];
  int length = snprintf(response, sizeof(response), "ERR %s\n", reason);
  if (length > 0 && (size_t)length < sizeof(response)) {
    (void)write_all(client, response, (size_t)length);
  }
}

static int open_workspace_source(const char *relative_path, struct stat *source_stat) {
  int current = dup(workspace_fd);
  if (current < 0) return -1;
  if (strcmp(relative_path, ".") == 0) {
    if (fstat(current, source_stat) != 0) {
      close(current);
      return -1;
    }
    return current;
  }
  if (relative_path[0] == '\0' || relative_path[0] == '/' ||
      relative_path[strlen(relative_path) - 1] == '/') {
    close(current);
    errno = EINVAL;
    return -1;
  }

  const char *cursor = relative_path;
  while (*cursor != '\0') {
    const char *separator = strchr(cursor, '/');
    size_t length = separator == NULL ? strlen(cursor) : (size_t)(separator - cursor);
    if (length == 0 || length > NAME_MAX ||
        (length == 1 && cursor[0] == '.') ||
        (length == 2 && cursor[0] == '.' && cursor[1] == '.')) {
      close(current);
      errno = EINVAL;
      return -1;
    }
    char component[NAME_MAX + 1];
    memcpy(component, cursor, length);
    component[length] = '\0';
    bool intermediate = separator != NULL;
    int next = openat(current, component, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (next < 0) {
      close(current);
      return -1;
    }
    struct stat component_stat;
    if (fstat(next, &component_stat) != 0 || S_ISLNK(component_stat.st_mode) ||
        (intermediate && !S_ISDIR(component_stat.st_mode))) {
      close(next);
      close(current);
      errno = ELOOP;
      return -1;
    }
    close(current);
    current = next;
    cursor = intermediate ? separator + 1 : cursor + length;
  }

  if (fstat(current, source_stat) != 0 ||
      (!S_ISDIR(source_stat->st_mode) && !S_ISREG(source_stat->st_mode))) {
    close(current);
    errno = EACCES;
    return -1;
  }
  return current;
}

static bool pin_source(
    const char *relative_path,
    char *target,
    size_t target_size,
    bool *directory_target) {
  if (alias_count >= MAX_ALIASES) {
    errno = ENOSPC;
    return false;
  }
  struct stat source_stat;
  int source_fd = open_workspace_source(relative_path, &source_stat);
  if (source_fd < 0) return false;

  char alias_directory[PATH_MAX];
  int template_length = snprintf(
      alias_directory, sizeof(alias_directory), "%s/pin-XXXXXX", workspace_view);
  if (template_length <= 0 || (size_t)template_length >= sizeof(alias_directory) ||
      mkdtemp(alias_directory) == NULL) {
    close(source_fd);
    return false;
  }
  if (chmod(alias_directory, 0711) != 0) {
    (void)rmdir(alias_directory);
    close(source_fd);
    return false;
  }
  int target_length = snprintf(
      target,
      target_size,
      "%s/%s",
      alias_directory,
      S_ISDIR(source_stat.st_mode) ? "source" : "source-file");
  if (target_length <= 0 || (size_t)target_length >= target_size) {
    rmdir(alias_directory);
    close(source_fd);
    errno = ENAMETOOLONG;
    return false;
  }

  bool directory = S_ISDIR(source_stat.st_mode);
  *directory_target = directory;
  int placeholder = -1;
  if (directory) {
    if (mkdir(target, 0711) != 0) goto rollback;
  } else {
    placeholder = open(target, O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
    if (placeholder < 0) goto rollback;
    close(placeholder);
    placeholder = -1;
  }

  char descriptor_path[64];
  int descriptor_length = snprintf(
      descriptor_path, sizeof(descriptor_path), "/proc/self/fd/%d", source_fd);
  if (descriptor_length <= 0 || (size_t)descriptor_length >= sizeof(descriptor_path) ||
      mount(descriptor_path, target, NULL, MS_BIND, NULL) != 0) {
    goto rollback;
  }

  struct stat target_stat;
  if (stat(target, &target_stat) != 0 || target_stat.st_dev != source_stat.st_dev ||
      target_stat.st_ino != source_stat.st_ino) {
    (void)umount2(target, MNT_DETACH);
    goto rollback;
  }
  close(source_fd);
  alias_count += 1;
  return true;

rollback:
  if (placeholder >= 0) close(placeholder);
  if (directory) (void)rmdir(target);
  else (void)unlink(target);
  (void)rmdir(alias_directory);
  close(source_fd);
  return false;
}

static bool rollback_source(const char *target, bool directory) {
  if (umount2(target, MNT_DETACH) != 0) return false;
  if ((directory ? rmdir(target) : unlink(target)) != 0) return false;

  char alias_directory[PATH_MAX];
  size_t target_length = strlen(target);
  if (target_length >= sizeof(alias_directory)) return false;
  memcpy(alias_directory, target, target_length + 1);
  char *separator = strrchr(alias_directory, '/');
  if (separator == NULL || separator == alias_directory) return false;
  *separator = '\0';
  size_t view_length = strlen(workspace_view);
  if (strncmp(alias_directory, workspace_view, view_length) != 0 ||
      alias_directory[view_length] != '/') {
    return false;
  }
  return rmdir(alias_directory) == 0;
}

static bool rollback_batch(char (*targets)[PATH_MAX], const bool *directories, size_t count) {
  bool complete = true;
  while (count > 0) {
    count -= 1;
    if (!rollback_source(targets[count], directories[count])) complete = false;
    if (alias_count > 0) alias_count -= 1;
  }
  return complete;
}

static void handle_client(int client) {
  struct ucred credentials;
  socklen_t credentials_length = sizeof(credentials);
  if (getsockopt(client, SOL_SOCKET, SO_PEERCRED, &credentials, &credentials_length) != 0 ||
      credentials_length != sizeof(credentials) || credentials.uid != allowed_uid) {
    respond_error(client, "workspace_bind_peer_denied");
    return;
  }

  struct timeval timeout = {.tv_sec = REQUEST_TIMEOUT_SECONDS, .tv_usec = 0};
  (void)setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  (void)setsockopt(client, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  char *request = malloc(MAX_REQUEST_BYTES + 1);
  if (request == NULL) {
    respond_error(client, "workspace_bind_request_failed");
    return;
  }
  size_t used = 0;
  while (used < MAX_REQUEST_BYTES) {
    ssize_t received = read(client, request + used, MAX_REQUEST_BYTES - used);
    if (received < 0) {
      if (errno == EINTR) continue;
      respond_error(client, "workspace_bind_request_failed");
      free(request);
      return;
    }
    if (received == 0) break;
    if (memchr(request + used, '\0', (size_t)received) != NULL) {
      respond_error(client, "workspace_bind_request_invalid");
      free(request);
      return;
    }
    used += (size_t)received;
  }
  if (used == 0 || used >= MAX_REQUEST_BYTES || request[used - 1] != '\n') {
    respond_error(client, "workspace_bind_request_invalid");
    free(request);
    return;
  }
  request[used] = '\0';

  char *header_end = strchr(request, '\n');
  if (header_end == NULL || strncmp(request, "BATCH ", 6) != 0) {
    respond_error(client, "workspace_bind_request_invalid");
    free(request);
    return;
  }
  *header_end = '\0';
  char *count_end = NULL;
  errno = 0;
  unsigned long requested = strtoul(request + 6, &count_end, 10);
  if (errno != 0 || count_end == request + 6 || *count_end != '\0' || requested == 0 ||
      requested > MAX_BATCH_ALIASES) {
    respond_error(client, "workspace_bind_request_invalid");
    free(request);
    return;
  }

  char **relative_paths = calloc(requested, sizeof(*relative_paths));
  char (*targets)[PATH_MAX] = calloc(requested, sizeof(*targets));
  bool *directories = calloc(requested, sizeof(*directories));
  if (relative_paths == NULL || targets == NULL || directories == NULL) {
    respond_error(client, "workspace_bind_request_failed");
    free(relative_paths);
    free(targets);
    free(directories);
    free(request);
    return;
  }

  char *cursor = header_end + 1;
  bool valid = true;
  for (size_t index = 0; index < requested; index += 1) {
    char *line_end = strchr(cursor, '\n');
    if (line_end == NULL || line_end == cursor) {
      valid = false;
      break;
    }
    *line_end = '\0';
    relative_paths[index] = cursor;
    cursor = line_end + 1;
  }
  if (!valid || *cursor != '\0') {
    respond_error(client, "workspace_bind_request_invalid");
    free(relative_paths);
    free(targets);
    free(directories);
    free(request);
    return;
  }

  size_t pinned = 0;
  for (; pinned < requested; pinned += 1) {
    if (!pin_source(
            relative_paths[pinned], targets[pinned], sizeof(targets[pinned]),
            &directories[pinned])) {
      break;
    }
  }
  if (pinned != requested) {
    int pin_error = errno;
    if (!rollback_batch(targets, directories, pinned)) fail("rollback broker aliases");
    fprintf(stderr, "workspace bind pin denied: %s\n", strerror(pin_error));
    respond_error(
        client,
        pin_error == ENOSPC ? "workspace_bind_alias_limit" : "workspace_bind_source_denied");
    free(relative_paths);
    free(targets);
    free(directories);
    free(request);
    return;
  }

  char response_header[64];
  int header_length = snprintf(response_header, sizeof(response_header), "OK %lu\n", requested);
  bool response_ok = header_length > 0 && (size_t)header_length < sizeof(response_header) &&
                     write_all(client, response_header, (size_t)header_length);
  for (size_t index = 0; response_ok && index < requested; index += 1) {
    response_ok = write_all(client, targets[index], strlen(targets[index])) &&
                  write_all(client, "\n", 1);
  }
  (void)response_ok;
  free(relative_paths);
  free(targets);
  free(directories);
  free(request);
}

static unsigned long parse_identity(const char *value) {
  char *end = NULL;
  errno = 0;
  unsigned long parsed = strtoul(value, &end, 10);
  if (errno != 0 || end == value || *end != '\0' || parsed > UINT32_MAX) {
    fprintf(stderr, "invalid broker identity\n");
    exit(EXIT_FAILURE);
  }
  return parsed;
}

int main(int argc, char **argv) {
  if (argc != 6) {
    fprintf(stderr, "usage: facility-bind-broker SOCKET WORKSPACE VIEW UID GID\n");
    return EXIT_FAILURE;
  }
  const char *socket_path = argv[1];
  const char *workspace_root = argv[2];
  if (realpath(argv[3], workspace_view) == NULL) fail("realpath workspace view");
  allowed_uid = (uid_t)parse_identity(argv[4]);
  gid_t allowed_gid = (gid_t)parse_identity(argv[5]);
  workspace_fd = open(workspace_root, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (workspace_fd < 0) fail("open workspace root");

  int server = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (server < 0) fail("create broker socket");
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (strlen(socket_path) >= sizeof(address.sun_path)) {
    fprintf(stderr, "broker socket path too long\n");
    return EXIT_FAILURE;
  }
  memcpy(address.sun_path, socket_path, strlen(socket_path) + 1);
  (void)unlink(socket_path);
  if (bind(server, (struct sockaddr *)&address, sizeof(address)) != 0 ||
      chown(socket_path, allowed_uid, allowed_gid) != 0 || chmod(socket_path, 0600) != 0 ||
      listen(server, 16) != 0) {
    fail("configure broker socket");
  }

  signal(SIGPIPE, SIG_IGN);
  for (;;) {
    int client = accept4(server, NULL, NULL, SOCK_CLOEXEC);
    if (client < 0) {
      if (errno == EINTR) continue;
      fail("accept broker client");
    }
    handle_client(client);
    close(client);
  }
}
