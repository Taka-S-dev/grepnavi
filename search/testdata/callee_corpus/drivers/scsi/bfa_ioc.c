/* Return type on its own line; prototypes live in the header (linux drivers). */
#include "bfa_ioc.h"

static void
bfa_ioc_send_enable(struct bfa_ioc *ioc)
{
	struct bfi_ioc_ctrl_req enable_req;

	bfi_h2i_set(enable_req.mh, BFI_MC_IOC, BFI_IOC_H2I_ENABLE_REQ,
		    bfa_ioc_portid(ioc));
	enable_req.clscode = cpu_to_be16(ioc->clscode);
	bfa_ioc_mbox_send(ioc, &enable_req, sizeof(struct bfi_ioc_ctrl_req));
}

static void
bfa_ioc_send_getattr(struct bfa_ioc *ioc)
{
	struct bfi_ioc_getattr_req attr_req;

	bfi_h2i_set(attr_req.mh, BFI_MC_IOC, BFI_IOC_H2I_GETATTR_REQ,
		    bfa_ioc_portid(ioc));
	bfa_dma_be_addr_set(attr_req.attr_addr, ioc->attr_dma.pa);
	bfa_ioc_mbox_send(ioc, &attr_req, sizeof(attr_req));
}

bfa_status_t
bfa_ioc_fwsig_invalidate(struct bfa_ioc *ioc)
{
	u32 pgnum;
	u32 loff = 0;

	pgnum = PSS_SMEM_PGNUM(ioc->ioc_regs.smem_pg0, loff);
	writel(pgnum, ioc->ioc_regs.host_page_num_fn);
	writel(BFI_IOC_FW_INV_SIGN, ioc->ioc_regs.smem_page_start + loff);
	return BFA_STATUS_OK;
}

static ssize_t
version_fw_show(struct device *cdev, struct device_attribute *attr, char *buf)
{
	struct Scsi_Host *shost = class_to_shost(cdev);
	struct MPT3SAS_ADAPTER *ioc = shost_priv(shost);

	return snprintf(buf, PAGE_SIZE, "%02d.%02d.%02d.%02d\n",
	    (ioc->facts.FWVersion.Word & 0xFF000000) >> 24,
	    (ioc->facts.FWVersion.Word & 0x00FF0000) >> 16,
	    (ioc->facts.FWVersion.Word & 0x0000FF00) >> 8,
	    ioc->facts.FWVersion.Word & 0x000000FF);
}

void __acquires(&ioc->lock)
bfa_ioc_lock_and_poll(struct bfa_ioc *ioc)
{
	spin_lock(&ioc->lock);
	bfa_ioc_mbox_poll(ioc);
}
