/* Return type with a macro call on its own line (openssl). */
#include "p12_local.h"

const STACK_OF(PKCS12_SAFEBAG) *
PKCS12_SAFEBAG_get0_safes(const PKCS12_SAFEBAG *bag)
{
    if (OBJ_obj2nid(bag->type) != NID_safeContentsBag)
        return NULL;
    return bag->value.safes;
}

int PKCS12_SAFEBAG_get_nid(const PKCS12_SAFEBAG *bag)
{
    return OBJ_obj2nid(bag->type);
}
