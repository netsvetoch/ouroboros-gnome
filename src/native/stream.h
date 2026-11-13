#pragma once
#include <gio/gio.h>
G_BEGIN_DECLS
#define OUROBOROS_TYPE_BOUNDED_STREAM (ouroboros_bounded_stream_get_type())
G_DECLARE_FINAL_TYPE(OuroborosBoundedStream, ouroboros_bounded_stream, OUROBOROS, BOUNDED_STREAM, GInputStream)
/**
 * ouroboros_bounded_stream_new:
 * Returns: (transfer full): A bounded producer/consumer input stream.
 */
OuroborosBoundedStream *ouroboros_bounded_stream_new(void);
/**
 * ouroboros_bounded_stream_write_async:
 * @self: the stream
 * @bytes: bytes to enqueue (at most 65536)
 * @cancellable: (nullable): cancellation
 * @callback: (scope async) (closure user_data): completion on the caller's main context
 * @user_data: callback data
 */
void ouroboros_bounded_stream_write_async(OuroborosBoundedStream *self, GBytes *bytes, GCancellable *cancellable, GAsyncReadyCallback callback, gpointer user_data);
gboolean ouroboros_bounded_stream_write_finish(OuroborosBoundedStream *self, GAsyncResult *result, GError **error);
void ouroboros_bounded_stream_end(OuroborosBoundedStream *self);
void ouroboros_bounded_stream_fail(OuroborosBoundedStream *self, const gchar *message);
G_END_DECLS
