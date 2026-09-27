/* MIT, Agent Call Bridge. Baresip itself remains BSD-3-Clause.
 * MSVC does not provide getopt, so upstream main ignores -f in that build.
 * This entrypoint always uses its owned process working directory and never
 * creates or loads the user's global baresip configuration.
 */
#define main acb_baresip_main
#include BARESIP_UPSTREAM_MAIN
#undef main

int main(int argc, char *argv[])
{
    int err;
    FILE *config;
    FILE *accounts;
    (void)argc;
    config = fopen("config", "rb");
    accounts = fopen("accounts", "rb");
    if (!config || !accounts) {
        if (config) fclose(config);
        if (accounts) fclose(accounts);
        fprintf(stderr, "Agent Call Bridge must prepare the local SIP configuration first.\n");
        return 2;
    }
    fclose(config);
    fclose(accounts);
    err = conf_path_set(".");
    if (err)
        return err;
    return acb_baresip_main(1, argv);
}
