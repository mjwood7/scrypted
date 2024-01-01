cd /tmp
curl -O -L https://github.com/koush/scrypted/releases/download/v0.72.0/scrypted.tar.zst
pct restore 10443 scrypted.tar.zst

function readyn() {
    while true; do
        read -p "$1 (y/n) " yn
        case $yn in
            [Yy]* ) break;;
            [Nn]* ) break;;
            * ) echo "Please answer yes or no. (y/n)";;
        esac
    done
}

echo "Adding udev rule: /etc/udev/rules.d/65-scrypted.rules"
readyn "Add udev rule for hardware acceleration? This may conflict with existing rules."
if [ "$yn" == "y" ]
then
    sh -c "echo 'SUBSYSTEM==\"apex\", MODE=\"0666\"' > /etc/udev/rules.d/65-scrypted.rules"
    sh -c "echo 'KERNEL==\"renderD128\", MODE=\"0666\"' >> /etc/udev/rules.d/65-scrypted.rules"
    sh -c "echo 'KERNEL==\"card0\", MODE=\"0666\"' >> /etc/udev/rules.d/65-scrypted.rules"
    udevadm control --reload-rules && udevadm trigger
fi

echo "Scrypted setup is complete and the container can be started."