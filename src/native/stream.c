#include "stream.h"
#include <string.h>

struct _OuroborosBoundedStream {
  GInputStream parent_instance;
  GMutex mutex;
  GCond condition;
  GQueue queue;
  gsize queued, offset;
  gboolean ended;
  gchar *failure;
};
G_DEFINE_TYPE(OuroborosBoundedStream, ouroboros_bounded_stream, G_TYPE_INPUT_STREAM)
#define BOUND (128 * 1024)

static gssize read_stream(GInputStream *stream, void *buffer, gsize count, GCancellable *cancel, GError **error) {
  OuroborosBoundedStream *self = OUROBOROS_BOUNDED_STREAM(stream);
  g_mutex_lock(&self->mutex);
  while (g_queue_is_empty(&self->queue) && !self->ended && !self->failure && !g_cancellable_is_cancelled(cancel))
    g_cond_wait_until(&self->condition, &self->mutex, g_get_monotonic_time() + 100000);
  if (g_cancellable_is_cancelled(cancel)) {
    if (!self->failure) self->failure = g_strdup("Stream cancelled");
    g_cond_broadcast(&self->condition);
    g_cancellable_set_error_if_cancelled(cancel, error);
    g_mutex_unlock(&self->mutex); return -1;
  }
  if (self->failure) {
    g_set_error_literal(error, G_IO_ERROR, G_IO_ERROR_FAILED, self->failure);
    g_mutex_unlock(&self->mutex); return -1;
  }
  GBytes *head = g_queue_peek_head(&self->queue);
  if (!head) { g_mutex_unlock(&self->mutex); return 0; }
  gsize size;
  const guint8 *data = g_bytes_get_data(head, &size);
  gsize take = MIN(count, size - self->offset);
  memcpy(buffer, data + self->offset, take);
  self->offset += take; self->queued -= take;
  if (self->offset == size) { g_bytes_unref(g_queue_pop_head(&self->queue)); self->offset = 0; }
  g_cond_broadcast(&self->condition);
  g_mutex_unlock(&self->mutex); return take;
}

static gboolean close_stream(GInputStream *stream, GCancellable *cancel, GError **error) {
  (void)cancel; (void)error;
  ouroboros_bounded_stream_fail(OUROBOROS_BOUNDED_STREAM(stream), "Stream closed");
  return TRUE;
}
static void finalize(GObject *object) {
  OuroborosBoundedStream *self = OUROBOROS_BOUNDED_STREAM(object);
  g_queue_clear_full(&self->queue, (GDestroyNotify)g_bytes_unref);
  g_free(self->failure); g_mutex_clear(&self->mutex); g_cond_clear(&self->condition);
  G_OBJECT_CLASS(ouroboros_bounded_stream_parent_class)->finalize(object);
}
static void ouroboros_bounded_stream_class_init(OuroborosBoundedStreamClass *klass) {
  G_INPUT_STREAM_CLASS(klass)->read_fn = read_stream;
  G_INPUT_STREAM_CLASS(klass)->close_fn = close_stream;
  G_OBJECT_CLASS(klass)->finalize = finalize;
}
static void ouroboros_bounded_stream_init(OuroborosBoundedStream *self) {
  g_mutex_init(&self->mutex); g_cond_init(&self->condition); g_queue_init(&self->queue);
}
OuroborosBoundedStream *ouroboros_bounded_stream_new(void) { return g_object_new(OUROBOROS_TYPE_BOUNDED_STREAM, NULL); }

static void write_task(GTask *task, gpointer source, gpointer data, GCancellable *cancel) {
  OuroborosBoundedStream *self = source;
  GBytes *bytes = data;
  gsize size = g_bytes_get_size(bytes);
  if (size > 65536) { g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_NO_SPACE, "Chunk exceeds stream bound"); return; }
  g_mutex_lock(&self->mutex);
  while (self->queued + size > BOUND && !self->ended && !self->failure && !g_cancellable_is_cancelled(cancel))
    g_cond_wait_until(&self->condition, &self->mutex, g_get_monotonic_time() + 100000);
  if (g_cancellable_is_cancelled(cancel) || self->failure || self->ended) {
    g_mutex_unlock(&self->mutex);
    g_task_return_new_error(task, G_IO_ERROR, G_IO_ERROR_CANCELLED, "Stream is no longer writable"); return;
  }
  if (size) { g_queue_push_tail(&self->queue, g_bytes_ref(bytes)); self->queued += size; }
  g_cond_broadcast(&self->condition);
  g_mutex_unlock(&self->mutex); g_task_return_boolean(task, TRUE);
}
void ouroboros_bounded_stream_write_async(OuroborosBoundedStream *self, GBytes *bytes, GCancellable *cancel, GAsyncReadyCallback callback, gpointer data) {
  GTask *task = g_task_new(self, cancel, callback, data);
  g_task_set_task_data(task, g_bytes_ref(bytes), (GDestroyNotify)g_bytes_unref);
  g_task_run_in_thread(task, write_task); g_object_unref(task);
}
gboolean ouroboros_bounded_stream_write_finish(OuroborosBoundedStream *self, GAsyncResult *result, GError **error) {
  g_return_val_if_fail(g_task_is_valid(result, self), FALSE);
  return g_task_propagate_boolean(G_TASK(result), error);
}
void ouroboros_bounded_stream_end(OuroborosBoundedStream *self) {
  g_mutex_lock(&self->mutex); self->ended = TRUE;
  g_cond_broadcast(&self->condition); g_mutex_unlock(&self->mutex);
}
void ouroboros_bounded_stream_fail(OuroborosBoundedStream *self, const gchar *message) {
  g_mutex_lock(&self->mutex);
  if (!self->failure) self->failure = g_strdup(message);
  g_cond_broadcast(&self->condition); g_mutex_unlock(&self->mutex);
}
