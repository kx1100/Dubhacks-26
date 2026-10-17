#ifndef LOGGER_H
#define LOGGER_H

#ifdef __cplusplus
extern "C" {
#endif

typedef enum { LOG_DEBUG, LOG_INFO, LOG_ERROR } log_level;

typedef struct {
    int fd;
    log_level min_level;
} logger_t;

void log_init(const char* path);
void log_message(log_level level, const char* msg);
void log_close(void);

#ifdef __cplusplus
}
#endif

#endif
