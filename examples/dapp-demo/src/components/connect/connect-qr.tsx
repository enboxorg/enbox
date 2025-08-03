import { QRCodeCanvas } from "qrcode.react";
import { Typography } from "../ui/typography";
import { Button } from "../ui/button";
import { XIcon } from "lucide-react";

interface ConnectQRProps {
  value: string;
  close: () => void;
}

const ConnectQR: React.FC<ConnectQRProps> = ({ close, value }) => {

  const copyQRValue = (e: React.MouseEvent<HTMLElement>) => {
    navigator.clipboard.writeText(value);
    const currentTarget = e.currentTarget;

    currentTarget.classList.add('tooltip-active');
    setTimeout(() => currentTarget.classList.remove('tooltip-active'), 1000);
  }

  return (<div>
    <Typography variant="h3">Scan QR Code</Typography>
    <a href={value} onClick={copyQRValue} className="tooltip-action">
      <span className="tooltip bg-background text-primary">Copied</span>
      <QRCodeCanvas value={value} size={256} className="mt-4 p-2 bg-primary" bgColor="rgb(250,204, 21)" fgColor="rgb(41,37,36)" />
    </a>
    <div className="mt-4">
      <Button onClick={() => close()}>Cancel <XIcon className="ml-2 h-4 w-4" /></Button>
    </div>
  </div>)
}

export default ConnectQR;