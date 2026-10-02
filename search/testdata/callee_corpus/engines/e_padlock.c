/* Function preceded by a run of file-scope macro invocations (openssl). */
#include "padlock.h"

DECLARE_AES_EVP(128, ecb, ECB)
DECLARE_AES_EVP(128, cbc, CBC)
DECLARE_AES_EVP(128, cfb, CFB)
DECLARE_AES_EVP(128, ofb, OFB)
DECLARE_AES_EVP(128, ctr, CTR)
DECLARE_AES_EVP(192, ecb, ECB)
DECLARE_AES_EVP(192, cbc, CBC)
DECLARE_AES_EVP(192, cfb, CFB)
DECLARE_AES_EVP(192, ofb, OFB)
DECLARE_AES_EVP(192, ctr, CTR)
DECLARE_AES_EVP(256, ecb, ECB)
DECLARE_AES_EVP(256, cbc, CBC)
DECLARE_AES_EVP(256, cfb, CFB)
DECLARE_AES_EVP(256, ofb, OFB)
DECLARE_AES_EVP(256, ctr, CTR)
DECLARE_AES_EVP(384, ecb, ECB)
DECLARE_AES_EVP(384, cbc, CBC)
DECLARE_AES_EVP(384, cfb, CFB)
DECLARE_AES_EVP(384, ofb, OFB)
DECLARE_AES_EVP(384, ctr, CTR)
DECLARE_AES_EVP(512, ecb, ECB)
DECLARE_AES_EVP(512, cbc, CBC)
DECLARE_AES_EVP(512, cfb, CFB)
DECLARE_AES_EVP(512, ofb, OFB)
DECLARE_AES_EVP(512, ctr, CTR)

static int
padlock_ciphers(ENGINE *e, const EVP_CIPHER **cipher, const int **nids,
                int nid)
{
    /* No specific cipher => return a list of supported nids ... */
    if (!cipher) {
        *nids = padlock_cipher_nids;
        return padlock_cipher_nids_num;
    }

    switch (nid) {
    case NID_aes_128_ecb:
        *cipher = padlock_aes_128_ecb();
        break;
    case NID_aes_192_cbc:
        *cipher = padlock_aes_192_cbc();
        break;
    default:
        *cipher = NULL;
        return padlock_report_unknown(nid);
    }
    return 1;
}

static int padlock_aes_init_key(EVP_CIPHER_CTX *ctx, const unsigned char *key)
{
    struct padlock_cipher_data *cdata = ALIGNED_CIPHER_DATA(ctx);
    padlock_key_setup(key, cdata);
    return padlock_reload_key(cdata);
}
