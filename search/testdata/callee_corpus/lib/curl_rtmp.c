/* A function listed in many function-pointer tables before its definition (curl). */
#include "curl_setup.h"

const struct Curl_handler Curl_handler_rtmp = {
  "rtmp",                               /* scheme */
  rtmp_setup_connection,                /* setup_connection */
  rtmp_do,                              /* do_it */
  rtmp_done,                            /* done */
  rtmp_disconnect,                      /* disconnect */
};

const struct Curl_handler Curl_handler_rtmpt = {
  "rtmpt",
  rtmp_setup_connection,
  rtmp_do,
  rtmp_done,
  rtmp_disconnect,
};

const struct Curl_handler Curl_handler_rtmpe = {
  "rtmpe",
  rtmp_setup_connection,
  rtmp_do,
  rtmp_done,
  rtmp_disconnect,
};

const struct Curl_handler Curl_handler_rtmpte = {
  "rtmpte",
  rtmp_setup_connection,
  rtmp_do,
  rtmp_done,
  rtmp_disconnect,
};

const struct Curl_handler Curl_handler_rtmps = {
  "rtmps",
  rtmp_setup_connection,
  rtmp_do,
  rtmp_done,
  rtmp_disconnect,
};

const struct Curl_handler Curl_handler_rtmpts = {
  "rtmpts",
  rtmp_setup_connection,
  rtmp_do,
  rtmp_done,
  rtmp_disconnect,
};

static CURLcode rtmp_setup_connection(struct Curl_easy *data,
                                      struct connectdata *conn)
{
  RTMP *r = RTMP_Alloc();
  if(!r)
    return CURLE_OUT_OF_MEMORY;
  RTMP_Init(r);
  return Curl_conn_meta_set(data, conn, CURL_META_RTMP_CONN, r, rtmp_conn_dtor);
}

static CURLcode rtmp_do(struct Curl_easy *data, bool *done)
{
  RTMP *r = Curl_conn_meta_get(data->conn, CURL_META_RTMP_CONN);
  if(!r || !RTMP_ConnectStream(r, 0))
    return CURLE_FAILED_INIT;
  Curl_xfer_setup1(data, CURL_XFER_RECV, -1, FALSE);
  *done = TRUE;
  return CURLE_OK;
}

static CURLcode rtmp_done(struct Curl_easy *data, CURLcode status,
                          bool premature)
{
  (void)data;
  (void)status;
  (void)premature;
  return CURLE_OK;
}

static CURLcode rtmp_disconnect(struct Curl_easy *data,
                                struct connectdata *conn,
                                bool dead_connection)
{
  RTMP *r = Curl_conn_meta_get(conn, CURL_META_RTMP_CONN);
  (void)data;
  (void)dead_connection;
  if(r)
    RTMP_Close(r);
  return CURLE_OK;
}
