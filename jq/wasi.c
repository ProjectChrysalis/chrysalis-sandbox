/* Linked into jq for WASI. A WASI program starts in "/", so the shell's
 * directory (PWD) is entered before main; and jq keeps per-thread state in
 * pthread keys, which in a one-thread guest are plain slots. */
#include <stdlib.h>
#include <unistd.h>

__attribute__((constructor)) static void enter_pwd(void)
{
	const char *pwd = getenv("PWD");
	if (pwd && *pwd)
		chdir(pwd);
}

typedef unsigned pthread_key_t;
typedef int pthread_once_t;
static void *slots[64];
static unsigned next_key;

int pthread_key_create(pthread_key_t *key, void (*destructor)(void *))
{
	(void)destructor;
	if (next_key >= 64)
		return 11;
	*key = next_key++;
	return 0;
}

void *pthread_getspecific(pthread_key_t key)
{
	return key < 64 ? slots[key] : 0;
}

int pthread_setspecific(pthread_key_t key, const void *value)
{
	if (key >= 64)
		return 22;
	slots[key] = (void *)value;
	return 0;
}

int pthread_once(pthread_once_t *once, void (*init)(void))
{
	if (!*once) {
		*once = 1;
		init();
	}
	return 0;
}
