#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#else
#define _POSIX_C_SOURCE 200809L
#endif
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#if defined(__linux__)
#include <linux/fs.h>
#include <linux/magic.h>
#include <sys/ioctl.h>
#include <sys/vfs.h>
#elif defined(__APPLE__)
#include <sys/attr.h>
#endif

/* Only positively identified kernel semantics are authoritative. In particular,
 * DrvFS exposes no usable system.wsl_case_sensitive attribute on the tested WSL
 * host. Neither a mount name nor a case-alias probe establishes its lookup mode.
 */
static const char *directory_mode(int fd) {
    if (fd < 0) return "unknown";
#if defined(__linux__)
    struct statfs filesystem;
    if (fstatfs(fd, &filesystem) != 0) return "unknown";
    /* Both getters expose FS_CASEFOLD_FL, not just an unrelated flag subset.
     * tmpfs gained per-directory casefold in Linux 6.13. A failed query on
     * older kernels remains unknown instead of inferring sensitivity by type.
     */
    if (filesystem.f_type == EXT4_SUPER_MAGIC || filesystem.f_type == TMPFS_MAGIC) {
        int flags = 0;
        if (ioctl(fd, FS_IOC_GETFLAGS, &flags) != 0) return "unknown";
        return (flags & FS_CASEFOLD_FL) ? "insensitive" : "sensitive";
    }
#elif defined(__APPLE__)
    struct attrlist attributes = {0};
    struct {
        unsigned int length;
        vol_capabilities_attr_t capabilities;
    } result = {0};
    attributes.bitmapcount = ATTR_BIT_MAP_COUNT;
    attributes.volattr = ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES;
    if (fgetattrlist(fd, &attributes, &result, sizeof(result), 0) != 0)
        return "unknown";
    if (result.length < sizeof(result)) return "unknown";
    if (!(result.capabilities.valid[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_CASE_SENSITIVE))
        return "unknown";
    return (result.capabilities.capabilities[VOL_CAPABILITIES_FORMAT] & VOL_CAP_FMT_CASE_SENSITIVE)
        ? "sensitive" : "insensitive";
#endif
    return "unknown";
}

/* Keep these protocol bounds in sync with src/lookup.ts. Include the terminal
 * NUL in each path's byte limit. Parse the entire batch before writing output.
 */
#define MAX_PATH_BYTES 4096
#define MAX_BATCH_PATHS 256
#define MAX_BATCH_BYTES (64 * 1024)

/* Each path walks its existing, realpath-resolved directory chain.
 * Its row has one mode for / and one per component. Files, failed opens, and
 * every descendant of a failed open are unknown. Never follow a raced symlink.
 */
static void write_modes(char *target) {
    int directory = open("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    printf("[\"%s\"", directory_mode(directory));
    char *save = NULL;
    for (char *name = strtok_r(target, "/", &save); name; name = strtok_r(NULL, "/", &save)) {
        int next = directory < 0 ? -1 : openat(directory, name,
            O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        if (directory >= 0) close(directory);
        directory = next;
        printf(",\"%s\"", directory_mode(directory));
    }
    printf("]");
    if (directory >= 0) close(directory);
}

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    if (strcmp(argv[1], "--batch") == 0) {
        char input[MAX_BATCH_BYTES + 1];
        size_t offsets[MAX_BATCH_PATHS];
        size_t length = fread(input, 1, sizeof(input), stdin);
        if (ferror(stdin) || length > MAX_BATCH_BYTES) return 2;
        size_t count = 0;
        for (size_t offset = 0; offset < length;) {
            char *end = memchr(input + offset, '\0', length - offset);
            if (!end || input[offset] != '/' || count == MAX_BATCH_PATHS)
                return 2;
            size_t bytes = (size_t)(end - (input + offset)) + 1;
            if (bytes > MAX_PATH_BYTES) return 2;
            offsets[count++] = offset;
            offset += bytes;
        }
        printf("[");
        for (size_t index = 0; index < count; index++) {
            if (index) printf(",");
            write_modes(input + offsets[index]);
        }
        puts("]");
    } else {
        size_t length = strnlen(argv[1], MAX_PATH_BYTES);
        if (argv[1][0] != '/' || length == MAX_PATH_BYTES) return 2;
        char target[MAX_PATH_BYTES];
        memcpy(target, argv[1], length + 1);
        write_modes(target);
        putchar('\n');
    }
    return ferror(stdout) ? 1 : 0;
}
