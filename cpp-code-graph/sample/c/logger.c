#include "logger.h"
#include <stdio.h>

static logger_t g_logger = { -1, LOG_INFO };
static FILE* g_file = NULL;

static const char* level_name(log_level level)
{
    switch (level) {
    case LOG_DEBUG: return "debug";
    case LOG_INFO: return "info";
    default: return "error";
    }
}

void log_init(const char* path)
{
    g_file = fopen(path, "w");
    g_logger.fd = g_file ? 1 : -1;
}

void log_message(log_level level, const char* msg)
{
    if (level < g_logger.min_level || !g_file) return;
    fprintf(g_file, "[%s] %s\n", level_name(level), msg);
}

void log_close(void)
{
    if (g_file) fclose(g_file);
    g_file = NULL;
}
