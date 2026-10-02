/* Same-named static function in three sibling directories. */
#include "iwl-led.h"

static void iwl_led_brightness_set(struct led_classdev *led_cdev,
                                   enum led_brightness brightness)
{
    struct iwl_priv *priv = led_cdev_to_priv(led_cdev);
    iwl_mvm_led_cmd(priv, brightness > 0);
    iwl_led_log(priv, brightness);
}

static int mvm_led_register(struct iwl_priv *priv)
{
    priv->led.brightness_set = iwl_led_brightness_set;
    return led_classdev_register(priv->dev, &priv->led);
}
