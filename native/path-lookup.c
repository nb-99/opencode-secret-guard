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
    if (filesystem.f_type == EXT4_SUPER_MAGIC) {
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

/* A single invocation walks the existing, realpath-resolved directory chain.
 * Output has one mode for / and one per component. Files, failed opens, and
 * every descendant of a failed open are unknown. Never follow a raced symlink.
 */
int main(int argc, char **argv) {
    if (argc != 2 || argv[1][0] != '/') return 2;
    char *target = strdup(argv[1]);
    if (!target) return 2;
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
    puts("]");
    if (directory >= 0) close(directory);
    free(target);
    return ferror(stdout) ? 1 : 0;
}
