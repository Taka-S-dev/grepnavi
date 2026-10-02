#ifndef BFA_IOC_H
#define BFA_IOC_H

struct bfa_ioc;

bfa_status_t bfa_ioc_fwsig_invalidate(struct bfa_ioc *ioc);
void bfa_ioc_lock_and_poll(struct bfa_ioc *ioc);
void bfa_ioc_mbox_poll(struct bfa_ioc *ioc);
void bfa_ioc_mbox_send(struct bfa_ioc *ioc, void *msg, int len);

#endif
